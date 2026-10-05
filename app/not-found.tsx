import { Button, Container, Section } from "@/components/ui";

export default function NotFound() {
  return (
    <Section className="flex min-h-dvh items-center pt-[72px]">
      <Container>
        <div className="label font-mono text-fog">HTTP 404 · route not found</div>
        <h1 className="display mt-4 text-[72px] md:text-[160px]">No node here.</h1>
        <p className="mt-6 max-w-[460px] text-[17px] leading-relaxed text-ink/65">This route doesn&apos;t exist. The network does.</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Button href="/" arrow>
            Home
          </Button>
          <Button href="/brain" variant="secondary">
            See the network
          </Button>
        </div>
      </Container>
    </Section>
  );
}
