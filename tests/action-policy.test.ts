import { describe, expect, it } from "vitest";
import { checkClickName, checkFieldForTyping, checkGoal, checkTypedValue } from "@/lib/security/action-policy";

const field = (over: Partial<Parameters<typeof checkFieldForTyping>[0]>) => ({
  tag: "input",
  type: "text",
  autocomplete: "",
  name: "",
  id: "",
  placeholder: "",
  label: "",
  ...over,
});

describe("checkClickName", () => {
  it.each([
    "Buy now",
    "BUY NOW",
    "Place order",
    "Place your order",
    "Complete purchase",
    "Proceed to checkout",
    "Checkout",
    "Pay now",
    "Pay $49.00",
    "Confirm and pay",
    "Delete account",
    "Delete my account",
    "Cancel subscription",
    "Close account",
    "Transfer funds",
    "Send USDC",
    "Withdraw",
    "Sign up",
    "Register",
    "Create an account",
    "Subscribe",
    "Donate",
    "Change password",
    "Send message",
    "Submit payment",
    "Start free trial",
  ])("blocks %s", (name) => {
    expect(checkClickName(name).allowed).toBe(false);
  });

  it.each([
    "Search",
    "Submit",
    "Pricing",
    "Next",
    "Accept all cookies",
    "Accept all",
    "Reject all",
    "Learn more",
    "View PDF",
    "Add to cart",
    "Sort by price",
    "2012",
    "Order history",
    "Check out our blog",
    "Show more",
    "Remove filter",
    "Sign in",
  ])("allows %s", (name) => {
    expect(checkClickName(name).allowed).toBe(true);
  });
});

describe("checkFieldForTyping", () => {
  it("refuses password, card, secret and file fields", () => {
    expect(checkFieldForTyping(field({ type: "password" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ type: "file" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ autocomplete: "cc-number" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ autocomplete: "current-password" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ name: "cardnumber" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ placeholder: "CVV" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ label: "Seed phrase" })).allowed).toBe(false);
    expect(checkFieldForTyping(field({ id: "iban" })).allowed).toBe(false);
  });

  it("allows ordinary search and filter fields", () => {
    expect(checkFieldForTyping(field({ type: "search", name: "q", placeholder: "Search" })).allowed).toBe(true);
    expect(checkFieldForTyping(field({ name: "destination", label: "Where to?" })).allowed).toBe(true);
    expect(checkFieldForTyping(field({ type: "date", name: "checkin" })).allowed).toBe(true);
  });
});

describe("checkTypedValue", () => {
  it.each([
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "5500005555555559",
    "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "-----BEGIN RSA PRIVATE KEY-----",
  ])("refuses %s", (value) => {
    expect(checkTypedValue(value).allowed).toBe(false);
  });

  it.each(["Boston", "Sony WH-1000XM6", "Abu Dhabi", "2026-10-05", "1234 5678", "order 12345678901234", "hello world"])("allows %s", (value) => {
    expect(checkTypedValue(value).allowed).toBe(true);
  });
});

describe("checkGoal", () => {
  it.each([
    "Buy the cheapest headphones",
    "Find the cheapest room and book it then pay",
    "Transfer 100 USDC to this wallet",
    "Cancel my subscription",
    "Bypass the captcha on the login page",
    "Delete my account",
    "Sign up for a new account",
  ])("refuses %s", (goal) => {
    expect(checkGoal(goal).allowed).toBe(false);
  });

  it.each([
    "Find the cheapest available room tomorrow and tell me the price",
    "Find the price to buy Sony WH-1000XM6",
    "Navigate to pricing and return the Pro plan price",
    "Check if Product X is in stock",
    "Find the tender closing date",
    "Download the public PDF",
    "Find out how to cancel a subscription",
  ])("allows %s", (goal) => {
    expect(checkGoal(goal).allowed).toBe(true);
  });
});
