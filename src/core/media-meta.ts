/**
 * media-meta.ts — tiny pure helpers for inbound media metadata.
 *
 * Lives apart from client.ts/frame.ts so both can import the same MIME mapping
 * without a circular dependency (frame.ts already imports the NormalizedMessage
 * TYPE from client.ts; a value import back would cycle).
 */

/** Map a WeChat file `<fileext>` to a best-effort MIME type. */
export function fileExtToMime(ext: string | null | undefined): string {
  switch ((ext ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "rtf":
      return "application/rtf";
    case "zip":
      return "application/zip";
    case "rar":
      return "application/vnd.rar";
    case "7z":
      return "application/x-7z-compressed";
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

/** A filesystem-safe file name from a WeChat `<title>`, or a fallback. */
export function safeFileName(title: string | null | undefined, msgId: string, ext: string | null | undefined): string {
  const cleaned = (title ?? "").replace(/[\/\\\0\r\n]/g, "_").trim();
  if (cleaned) return cleaned;
  return `wechat-file-${msgId}.${(ext ?? "bin").toLowerCase()}`;
}
