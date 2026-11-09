import { z } from "zod";

/** A player's place in a game: 0 is whoever created it. Both games on the site have two. */
export const seatSchema = z.union([z.literal(0), z.literal(1)]);
export type Seat = z.infer<typeof seatSchema>;
