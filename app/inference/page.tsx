import { redirect } from "next/navigation";

/** The inference playground became BRAIN chat. */
export default function InferencePage() {
  redirect("/chat");
}
