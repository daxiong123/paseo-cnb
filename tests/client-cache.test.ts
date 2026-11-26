import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { checkConnection } from "../client/connection-cache.ts";
import { newRequestId, requestId } from "../shared/cnb.ts";

test("CLI account changes and failed checks discard only this host's CNB data", async () => {
  const cache = new QueryClient();
  const key = ["cnb", "host", "connection"];
  const queries = [["inbox", "issues", 1], ["inbox-issue", "project"], ["workspace", "pull", "12"]]
    .map((parts) => ["cnb", "host", ...parts]);
  const alice = { username: "alice", cliVersion: "1.24.14" };
  const bob = { ...alice, username: "bob" };
  const read = (account: typeof alice) => cache.fetchQuery({
    queryKey: key,
    queryFn: () => checkConnection(cache, "host", async () => account),
    staleTime: 0,
  });
  await read(alice);
  queries.forEach((query) => cache.setQueryData(query, "private"));
  cache.setQueryData(["cnb", "other", "inbox"], "other");
  await read(alice);
  queries.forEach((query) => assert.equal(cache.getQueryData(query), "private"));
  await read(bob);
  queries.forEach((query) => assert.equal(cache.getQueryData(query), undefined));
  cache.setQueryData(queries[0], "private to bob");
  await assert.rejects(checkConnection(cache, "host", async () => { throw new Error("denied"); }), /denied/);
  assert.equal(cache.getQueryData(queries[0]), undefined);
  assert.equal(cache.getQueryData(["cnb", "other", "inbox"]), "other");
  cache.clear();
});

test("user submissions have independent IDs accepted by the RPC contract", () => {
  const ids = Array.from({ length: 100 }, () => requestId.parse(newRequestId()));
  assert.equal(new Set(ids).size, ids.length);
});
