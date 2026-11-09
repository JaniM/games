import { z } from "zod";

/** What `GET /api/games` returns. */
export const gamesReplySchema = z.object({
  games: z.array(
    z.object({
      gameId: z.string(),
      kind: z.string(),
      seat: z.number().int(),
      joined: z.number().int(),
      started: z.boolean(),
      finished: z.boolean(),
      updatedAt: z.number(),
      playerNames: z.array(z.string().nullable()),
      playerGuests: z.array(z.boolean()),
    }),
  ),
});

/** What `POST /api/games` returns. */
export const createdReplySchema = z.object({ gameId: z.string(), seat: z.number().int() });
