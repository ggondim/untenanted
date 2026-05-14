import { z } from "zod";

export const UserRemovedEvent = z.object({
  type: z.literal("user.removed"),
  userId: z.string().min(1),
});
export type UserRemovedEvent = z.infer<typeof UserRemovedEvent>;

export const OrgRemovedEvent = z.object({
  type: z.literal("org.removed"),
  orgId: z.string().min(1),
});
export type OrgRemovedEvent = z.infer<typeof OrgRemovedEvent>;

export const NormalizedWebhookEvent = z.discriminatedUnion("type", [
  UserRemovedEvent,
  OrgRemovedEvent,
]);
export type NormalizedWebhookEvent = z.infer<typeof NormalizedWebhookEvent>;

export const WebhookAck = z.object({
  ok: z.literal(true),
  type: z.string(),
  affected: z.number().int().nonnegative(),
});
export type WebhookAck = z.infer<typeof WebhookAck>;
