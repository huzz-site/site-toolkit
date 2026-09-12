import { handleApi } from "./api";

export default {
  async fetch(request): Promise<Response> {
    return handleApi(request);
  },
} satisfies ExportedHandler<Env>;
