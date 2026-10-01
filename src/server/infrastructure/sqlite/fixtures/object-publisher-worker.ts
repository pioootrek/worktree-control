import { createHash } from "node:crypto";
import { publishAttachmentObject } from "../../../attachment-objects";
const bytes = Buffer.from("two simultaneous publishers"), sha256 = createHash("sha256").update(bytes).digest("hex");
process.once("message", () => {
  try { publishAttachmentObject(process.argv[2], { sha256, size: bytes.length }, bytes); process.send?.({ published: true }, () => process.exit(0)); }
  catch (error) { process.send?.({ error: error instanceof Error ? error.message : "Failed" }, () => process.exit(1)); }
});
process.send?.({ ready: true });
