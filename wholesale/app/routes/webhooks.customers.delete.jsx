import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import wholesaleApplicationServer from "../models/wholesaleApplication.server";
import { sendResponse } from "../services/APIService/api.service";

export async function action({ request }) {
  console.log("[webhooks/customers/delete] received webhook");
  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "CUSTOMERS_DELETE") {
    return sendResponse(400, "error", "Invalid webhook topic", null);
  }

  await connectDB();

  const customerId = "gid://shopify/Customer/" + payload.id;
  await wholesaleApplicationServer.deleteOne({ customerId, shop });

  return sendResponse(200, "success", "Customer deleted successfully", null);
}
