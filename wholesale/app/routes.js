import { route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";
export default [
  ...(await flatRoutes()),
  route("/api/registration-form", "api/registration-form.js"),
];
