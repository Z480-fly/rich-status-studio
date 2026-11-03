import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { chatSend, chatSearch, isParticipant } from "./chat-rules";

describe("private Zora messaging", () => {
  it("allows only sender and recipient to receive a message", () => {
    const message = { sender_id: "123", recipient_id: "456" };
    assert.equal(isParticipant("123", message), true);
    assert.equal(isParticipant("456", message), true);
    assert.equal(isParticipant("789", message), false);
  });
  it("rejects blank messages and messages over 2000 characters", () => {
    assert.equal(chatSend.safeParse({ peerId: "123", body: "   " }).success, false);
    assert.equal(chatSend.safeParse({ peerId: "123", body: "x".repeat(2000) }).success, true);
    assert.equal(chatSend.safeParse({ peerId: "123", body: "x".repeat(2001) }).success, false);
  });
  it("rejects non-Discord recipient IDs", () => {
    assert.equal(chatSend.safeParse({ peerId: "123),sender_id.neq.0", body: "hello" }).success, false);
  });
  it("requires at least two characters to search people", () => {
    assert.equal(chatSearch.safeParse({ query: "a" }).success, false);
    assert.equal(chatSearch.safeParse({ query: "ab" }).success, true);
  });
});