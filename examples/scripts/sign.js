// Pre-request script from a file: used with "< ./scripts/sign.js"
const timestamp = String($timestamp);
const signature = crypto.hmac.sha256()
  .withTextSecret(request.environment.get("hmacSecret"))
  .updateWithText(`${request.method}\n${timestamp}`)
  .digest().toHex();
request.variables.set("timestamp", timestamp);
request.variables.set("signature", signature);
