import { z } from "zod";

/** What `GET /api/me` and `PATCH /api/me` return. */
export const meSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
});
