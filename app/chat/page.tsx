import type { Metadata } from "next";
import { ChatApp } from "@/components/chat/ChatApp";

export const metadata: Metadata = { title: "Chat", description: "One request. The best available intelligence. Every answer comes with its receipt." };

export default function ChatPage() {
  return <ChatApp />;
}
