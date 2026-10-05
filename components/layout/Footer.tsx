import Link from "next/link";
import { Button, Container } from "@/components/ui";
import { FooterStatus } from "@/components/layout/FooterStatus";
import { StupifiedLink } from "@/components/layout/Stupified";
import { SocialLinks } from "@/components/layout/SocialLinks";
import { social } from "@/lib/site";

const cols = [
  { h: "Product", l: [["Chat", "/chat"], ["Pricing", "/pricing"], ["Account", "/account"], ["Power BRAIN", "/earn"]] },
  { h: "Network", l: [["Operations", "/network"], ["The Brain", "/brain"], ["Explorer", "/explorer"], ["Capacity", "/capacity"], ["Economics", "/economics"]] },
  { h: "Developers", l: [["API reference", "/developers"], ["BRAIN AUTO", "/auto"], ["Source", social.repoUrl], ["Verification", "/developers#verification"]] },
  { h: "Community", l: [["X / Twitter", social.xUrl], ["GitHub", social.githubUrl], ["Rewards", "/rewards"], ["Live economics", "/economics"]] },
];

export function Footer() {
  return (
    <footer data-theme="dark" className="surface-dark relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-chalk/20 to-transparent" />

      <Container className="relative pt-16 md:pt-20">
        <div className="flex flex-col justify-between gap-8 border-b border-chalk/10 pb-12 md:flex-row md:items-end">
          <h2 className="display-md max-w-[560px] text-[28px] leading-[1.02] md:text-[40px]">
            Use BRAIN.
            <br />
            <span className="text-chalk/40">Or power it and earn credits, USDC or SOL.</span>
          </h2>
          <div className="flex flex-wrap gap-3">
            <Button href="/chat" tone="dark" arrow>
              Use BRAIN
            </Button>
            <Button href="/earn" tone="dark" variant="secondary">
              Power BRAIN
            </Button>
          </div>
        </div>

        <div className="grid gap-12 py-12 lg:grid-cols-[1.2fr_2fr]">
          <div>
            <p className="max-w-[380px] text-[15px] leading-relaxed text-chalk/55">
              A distributed AI compute network. Browsers contribute verified GPU compute; creator fees and inference sales pay the people powering it.
            </p>
            <FooterStatus />
          </div>
          <nav className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {cols.map((c) => (
              <div key={c.h}>
                <div className="label mb-5 text-chalk/35">{c.h}</div>
                <ul className="space-y-3">
                  {c.l.map(([label, href]) => {
                    const ext = href.startsWith("http");
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                          className="group inline-flex items-center gap-1.5 text-[15px] text-chalk/75 transition-colors hover:text-chalk"
                        >
                          {label}
                          <span className="-translate-x-1 text-signal opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100">{ext ? "↗" : "→"}</span>
                        </Link>
                      </li>
                    );
                  })}
                  {c.h === "Product" && (
                    <li>
                      <StupifiedLink className="group inline-flex items-center gap-1.5 text-[15px] text-chalk/75 transition-colors hover:text-chalk" />
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="flex flex-col justify-between gap-2 border-t border-chalk/10 py-6 font-mono text-[11px] tracking-wide text-chalk/35 md:flex-row md:items-center">
          <span className="flex items-center gap-3">
            <span className="text-[13px] font-semibold tracking-[-0.03em] text-chalk/70">
              brain<span className="text-signal">.</span>
            </span>
            <span>© {new Date().getFullYear()} BRAIN (working name) · Experimental software · Not an investment; rewards are not guaranteed</span>
          </span>
          <span className="flex items-center gap-4">
            <span>SIM = demo data · EST = illustrative estimate</span>
            <SocialLinks dark />
          </span>
        </div>
      </Container>
    </footer>
  );
}
