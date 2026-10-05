"use client";

import { useEffect } from "react";
import { Button, Container, Section } from "@/components/ui";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Section className="flex min-h-dvh items-center pt-[72px]">
      <Container>
        <div className="label font-mono text-fog">Something broke{error.digest ? ` · ${error.digest}` : ""}</div>
        <h1 className="display mt-4 text-[64px] md:text-[136px]">Node fault.</h1>
        <p className="mt-6 max-w-[460px] text-[17px] leading-relaxed text-ink/65">This page hit an unexpected error. The network is fine; try again.</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Button onClick={reset} arrow>
            Try again
          </Button>
          <Button href="/" variant="secondary">
            Home
          </Button>
        </div>
      </Container>
    </Section>
  );
}
