import { request } from "node:http";

/** TCP reset makes disconnection observable even while workerd is awaiting a yield. */
export function openResettableUpload(url: string, authorization: string, head: string) {
  return new Promise<{ reset(): void }>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        agent: false,
        headers: { authorization, "content-type": "application/x-git-upload-pack-request" },
      },
      (incoming) => {
        if (incoming.statusCode !== 200) {
          incoming.resume();
          reject(new Error(`cancellation upload returned HTTP ${incoming.statusCode}`));
          return;
        }
        let transportError: Error | undefined;
        incoming.on("error", (error: Error) => {
          transportError = error;
        });
        resolve({
          reset() {
            if (transportError !== undefined) throw transportError;
            if (incoming.socket.destroyed)
              throw new Error("upload disconnected before the cancellation witness");
            incoming.socket.resetAndDestroy();
          },
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(`0032want ${head}\n00000009done\n`);
  });
}
