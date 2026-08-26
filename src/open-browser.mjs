import { execFile } from "node:child_process";

export function openInBrowser(
  url,
  { platform = process.platform, execFileImpl = execFile } = {},
) {
  const [command, commandArgs] =
    platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    execFileImpl(command, commandArgs, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
