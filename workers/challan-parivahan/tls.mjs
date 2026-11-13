// TLS trust for the Parivahan portal.
//
// The portal serves a Let's Encrypt chain whose root ("ISRG Root YE") is newer than
// Node's bundled CA list and is NOT sent by the server. That root is cross-signed by
// the universally-trusted "ISRG Root X2", so bundling it lets Node bridge the chain
// WITHOUT ever disabling certificate verification. We trust the default CAs PLUS this
// one extra root — nothing is weakened.
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { Agent } from "undici";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bundledRoots() {
  try {
    const pem = fs.readFileSync(path.join(__dirname, "isrg-root-ye.pem"), "utf8");
    if (pem.includes("BEGIN CERTIFICATE")) return [pem];
  } catch {
    /* missing bundle: fall back to defaults only */
  }
  return [];
}

// Default roots + the bundled cross-signed Root YE. Verification stays ON.
const ca = [...tls.rootCertificates, ...bundledRoots()];

/** An undici Agent that fetch() uses as its dispatcher for portal calls. */
export const portalAgent = new Agent({
  connect: { ca },
});
