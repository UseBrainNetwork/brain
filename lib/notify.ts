/**
 * System notifications from the browser (Web Notifications API). Shown by macOS / Windows as a
 * native banner with the site icon. Permission can only be requested from a user gesture, so
 * call `requestNotifyPermission` from the click that starts the node.
 */

const supported = () => typeof window !== "undefined" && "Notification" in window;

export async function requestNotifyPermission(): Promise<boolean> {
  if (!supported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function notify(title: string, body: string, tag = "brain"): boolean {
  if (!supported() || Notification.permission !== "granted") return false;
  try {
    const n = new Notification(title, { body, tag, icon: "/brand/pfp-dark-400.png", badge: "/brand/mark-on-transparent-light.png", silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
