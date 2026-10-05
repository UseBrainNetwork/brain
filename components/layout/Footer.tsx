import Link from "next/link";
import { Button, Container } from "@/components/ui";
import { FooterStatus } from "@/components/layout/FooterStatus";

const cols = [
  { h: "Network", l: [["The Brain", "/brain"], ["Explorer", "/explorer"], ["Operations", "/network"], ["Capacity", "/capacity"], ["Contribute GPU", "/contribute"]] },
  { h: "Developers", l: [["API reference", "/developers"], ["BRAIN AUTO", "/auto"], ["Playground", "/inference#playground"], ["Models", "/inference"]] },
  { h: "Protocol", l: [["Your rewards", "/rewards"], ["Live economics", "/economics"], ["Earnings calculator", "/rewards#formula"], ["Verification", "/developers#verification"]] },
];

export function Footer() {
  return (
    <footer data-theme="dark" className="surface-dark relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-chalk/20 to-transparent" />

      <Container className="relative pt-16 md:pt-20">
        <div className="flex flex-col justify-between gap-8 border-b border-chalk/10 pb-12 md:flex-row md:items-end">
          <h2 className="display-md max-w-[560px] text-[28px] leading-[1.02] md:text-[40px]">
            Put your GPU
            <br />
            <span className="text-chalk/40">to work.</span>
          </h2>
          <div className="flex flex-wrap gap-3">
            <Button href="/contribute" tone="dark" arrow>
              Contribute GPU
            </Button>
            <Button href="/developers" tone="dark" variant="secondary">
              Read the API
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
                  {c.l.map(([label, href]) => (
                    <li key={href}>
                      <Link href={href} className="group inline-flex items-center gap-1.5 text-[15px] text-chalk/75 transition-colors hover:text-chalk">
                        {label}
                        <span className="-translate-x-1 text-signal opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100">→</span>
                      </Link>
                    </li>
                  ))}
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
          <span>SIM = demo data · EST = illustrative estimate</span>
        </div>
      </Container>
    </footer>
  );
}
