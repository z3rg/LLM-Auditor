// Dihasilkan oleh scripts/generate_agent_routes.mjs — jangan disunting tangan.
import { handleApi } from "../_api.js";

export async function onRequest(context) {
  return handleApi(context);
}

export default onRequest;
