import { z } from "zod";

export const chatAuth = z.object({ accessToken: z.string().max(4096).optional() });
export const chatSearch = chatAuth.extend({ query: z.string().trim().min(2).max(80) });
export const chatPeer = chatAuth.extend({ peerId: z.string().regex(/^\d{1,30}$/) });
export const chatSend = chatPeer.extend({ body: z.string().trim().min(1).max(2000) });
export function isParticipant(userId: string, message: { sender_id: string; recipient_id: string }) {
  return message.sender_id === userId || message.recipient_id === userId;
}