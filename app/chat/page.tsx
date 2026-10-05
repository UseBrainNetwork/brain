import type { Metadata } from "next";
import { ChatApp } from "@/components/chat/ChatApp";

export const metadata: Metadata = { title: "Chat", description: "Chat routed by BRAIN AUTO. Each answer shows the route, cost and receipt." };

export default function ChatPage() {
  return <ChatApp />;
}
