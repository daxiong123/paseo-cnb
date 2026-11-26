import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { RpcInput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { diffLines, pullFile, pullFiles, pullReview } from "../shared/pulls";
import { newRequestId } from "../shared/cnb";
import { PullError, PullInput, type Theme } from "./pull-ui";

type Review = RpcInput<typeof pullReview>;
type Snapshot = RpcInput<typeof pullFiles>;
type Location = Omit<Review["comments"][number], "body"> & { revision: string };
const decisions = [
  { value: "comment", label: "评论" },
  { value: "approve", label: "批准" },
  { value: "request_changes", label: "请求修改" },
] as const;

export function PullReview({ snapshot, queryKey, theme, isOpen, visible, refresh }: {
  snapshot: Snapshot; queryKey: readonly unknown[]; theme: Theme; isOpen: boolean; visible: boolean; refresh(): Promise<void>;
}) {
  const readFiles = useRpc(pullFiles);
  const readFile = useRpc(pullFile);
  const submit = useRpc(pullReview);
  const [path, setPath] = useState("");
  const [location, setLocation] = useState<Location | null>(null);
  const [lineBody, setLineBody] = useState("");
  const [comments, setComments] = useState<(Location & { body: string })[]>([]);
  const [event, setEvent] = useState<Review["event"]>("comment");
  const [body, setBody] = useState("");
  const revision = `${snapshot.head}:${snapshot.base}`;
  const [summaryRevision, setSummaryRevision] = useState(revision);
  const [lineLimit, setLineLimit] = useState(160);
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const files = useQuery({
    queryKey: [...queryKey, "files"], queryFn: () => readFiles(snapshot), enabled: visible, retry: false,
  });
  const file = useQuery({
    queryKey: [...queryKey, "file", path],
    queryFn: () => readFile({ ...snapshot, path }), enabled: visible && Boolean(path), retry: false,
  });
  const patch = file.isSuccess ? file.data.patch : "";
  const lines = useMemo(() => patch ? diffLines(patch) : [], [patch]);
  const review = useMutation({
    mutationFn: submit,
    onSuccess: () => {
      attempt.current = null;
      setBody(""); setComments([]); setEvent("comment"); setLocation(null); setLineBody("");
      return refresh();
    },
  });
  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  function selectFile(path: string) {
    setPath(path);
    setLineLimit(160);
    setLocation(null);
  }
  if (!visible) return null;
  const staleLines = comments.some((comment) => comment.revision !== revision);
  const staleSummary = Boolean(event !== "comment" || body.trim()) && summaryRevision !== revision;
  const canSubmit = isOpen && !review.isPending && !lineBody.trim() && !staleLines && !staleSummary
    && (event === "approve" || comments.length > 0 || Boolean(body.trim()));
  function submitDraft() {
    if (!canSubmit) return;
    const payload = { ...snapshot, event, body, comments: comments.map(({ revision: _, ...comment }) => comment) };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: newRequestId() };
    review.mutate({ ...payload, requestId: attempt.current.id });
  }
  return <View style={{ gap: 8 }}>
    <SettingsSelect label="变更文件" value={path} onValueChange={selectFile}
      disabled={review.isPending} options={[{ value: "", label: files.isFetching ? "正在加载" : "选择文件" },
        ...(files.isSuccess ? files.data : []).map((file) => ({ value: file.path, label: file.path }))]} />
    <PullError theme={theme} error={files.error?.message} retry={() => { void files.refetch(); }} />
    <PullError theme={theme} error={file.error?.message} retry={() => { void file.refetch(); }} />
    {file.isFetching && <Text style={muted}>正在读取差异</Text>}
    {file.isSuccess && !lines.length && <Text style={muted}>CNB 未返回此文件的文本差异。</Text>}
    {lines.length > 0 && <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }}>
      {lines.slice(0, lineLimit).map((line, index) => {
        const side = line.right !== null ? "right" : "left";
        const number = line[side];
        const selected = location?.revision === revision && location.path === path && location.line === number && location.side === side;
        const text = <Text selectable={!isOpen || number === null} style={{
          ...(number === null ? muted : foreground), fontFamily: "monospace", fontSize: 12, flex: 1, flexShrink: 1,
        }}>{line.text || " "}</Text>;
        return <Pressable key={index} accessibilityRole={number !== null && isOpen ? "button" : undefined}
          accessibilityLabel={number !== null && isOpen ? `评论第 ${number} 行 ${line.text}` : undefined}
          disabled={number === null || !isOpen || review.isPending}
          onPress={() => { if (number !== null) setLocation({ path, side, line: number, revision }); }}
          style={{ backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1, padding: 4, flexDirection: "row", gap: 6 }}>
          <Text style={{ ...muted, width: 66, fontFamily: "monospace", fontSize: 12 }}>{line.left ?? " "} {line.right ?? " "}</Text>
          {text}
        </Pressable>;
      })}
    </View>}
    {lineLimit < lines.length && <SettingsAction label={`已显示 ${lineLimit}/${lines.length} 行`}
      actionLabel="显示更多" onPress={() => setLineLimit(lineLimit + 160)} />}
    {file.isSuccess && file.data.truncated && <Text style={muted}>差异过长，仅显示开头的完整行，可在 CNB 查看完整差异。</Text>}
    {(staleLines || staleSummary || (location && location.revision !== revision)) &&
      <Text accessibilityRole="alert" style={foreground}>PR 版本已变化，请复核总结并为旧版本的逐行评论重新选择位置。</Text>}
    {(location || lineBody) && <>
      <Text style={foreground}>{location && location.revision === revision
        ? `${location.path} · ${location.side === "left" ? "旧版本" : "新版本"}第 ${location.line} 行`
        : "请在当前差异中选择评论行"}</Text>
      <PullInput theme={theme} accessibilityLabel="逐行评论" placeholder="逐行评论" value={lineBody}
        onChangeText={setLineBody} multiline maxLength={5000} editable={isOpen && !review.isPending} />
      <SettingsAction label={`待提交 ${comments.length}/20 条逐行评论`} actionLabel="加入评审"
        disabled={!isOpen || !location || location.revision !== revision || !lineBody.trim() || comments.length >= 20 || review.isPending}
        onPress={() => {
          if (location?.revision !== revision) return;
          setComments([...comments, { ...location, body: lineBody }]); setLocation(null); setLineBody("");
        }} />
      <SettingsAction label="当前逐行评论" actionLabel="取消编辑" disabled={review.isPending}
        onPress={() => { setLocation(null); setLineBody(""); }} />
    </>}
    {(isOpen || comments.length > 0 || Boolean(body)) && <SettingsCard>
      {comments.map((comment, index) => <View key={index}>
        <SettingsAction label={`${comment.path}:${comment.line}`}
          hint={comment.body} actionLabel="移除" disabled={review.isPending}
          onPress={() => setComments(comments.filter((_, item) => item !== index))} />
        {comment.revision !== revision && <SettingsAction label="旧版本逐行评论" actionLabel="重新选行"
          disabled={!isOpen || review.isPending || Boolean(lineBody.trim())} onPress={() => {
            selectFile(comment.path); setLocation(comment); setLineBody(comment.body);
            setComments(comments.filter((_, item) => item !== index));
          }} />}
      </View>)}
      <SettingsSelect<Review["event"]> label="评审结论" value={event} options={decisions}
        onValueChange={(value) => { setEvent(value); setSummaryRevision(revision); }} disabled={!isOpen || review.isPending} />
      <PullInput theme={theme} accessibilityLabel="评审总结" placeholder="评审总结" multiline maxLength={20000}
        value={body} onChangeText={(value) => { setBody(value); setSummaryRevision(revision); }} editable={isOpen && !review.isPending} />
      {staleSummary && <SettingsAction label={`当前提交 ${snapshot.head.slice(0, 12)}`} actionLabel="已复核总结与结论"
        disabled={!isOpen || review.isPending} onPress={() => setSummaryRevision(revision)} />}
      <SettingsAction label="将评审提交到 CNB" actionLabel={review.isPending ? "提交中" : "提交评审"}
        disabled={!canSubmit} onPress={submitDraft} />
    </SettingsCard>}
    {review.isSuccess && <Text accessibilityLiveRegion="polite" style={foreground}>评审已提交。</Text>}
    <PullError theme={theme} error={review.error?.message} />
  </View>;
}
