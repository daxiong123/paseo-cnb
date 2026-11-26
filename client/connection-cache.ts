import type { QueryClient } from "@tanstack/react-query";
import type { RpcOutput } from "@getpaseo/plugin";
import type { connection } from "../shared/cnb.ts";

type Account = RpcOutput<typeof connection>;

export async function checkConnection(cache: QueryClient, hostId: string, read: () => Promise<Account>) {
  const previous = cache.getQueryData<Account>(["cnb", hostId, "connection"]);
  let account: Account | undefined;
  try {
    account = await read();
    return account;
  } finally {
    if (!account || account.username !== previous?.username) {
      await cache.resetQueries({
        queryKey: ["cnb", hostId],
        predicate: (query) => query.queryKey[2] !== "connection",
      });
    }
  }
}
