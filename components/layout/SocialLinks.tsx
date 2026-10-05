import { cx } from "@/lib/format";
import { social } from "@/lib/site";

export function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2H21.5l-7.5 8.57L22.5 22h-6.9l-5.4-7.06L4 22H.744l8.02-9.17L.5 2h7.08l4.88 6.45L18.244 2Zm-1.21 18h1.8L7.04 3.9H5.1L17.034 20Z" />
    </svg>
  );
}

export function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.17 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.25 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

const items = [
  { href: social.xUrl, label: `@${social.xHandle} on X`, Icon: XIcon },
  { href: social.repoUrl, label: "Source on GitHub", Icon: GitHubIcon },
];

/** X + GitHub icon buttons. `dark` matches the surface the nav is currently over. */
export function SocialLinks({ dark, className, size = "sm" }: { dark: boolean; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={cx("flex items-center gap-1", className)}>
      {items.map(({ href, label, Icon }) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          title={label}
          className={cx(
            "grid place-items-center rounded-full transition-colors duration-300",
            size === "sm" ? "size-9" : "size-10",
            dark ? "text-chalk/60 hover:bg-chalk/10 hover:text-chalk" : "text-ink/55 hover:bg-ink/[0.06] hover:text-ink",
          )}
        >
          <Icon className={size === "sm" ? "size-[15px]" : "size-[17px]"} />
        </a>
      ))}
    </div>
  );
}
