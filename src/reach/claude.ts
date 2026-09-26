import net from "node:net";
export function claudeReachable(
  socketPath: string,
  deadline: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(
      () => finish(false),
      Math.max(1, Math.min(250, deadline - Date.now())),
    );
    function finish(result: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(result);
    }
    conn.once("connect", () => finish(true));
    conn.once("error", () => finish(false));
  });
}
