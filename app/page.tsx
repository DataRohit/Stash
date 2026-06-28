import { Architecture } from "@/components/landing/architecture";
import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { Marquee } from "@/components/landing/marquee";
import { Navbar } from "@/components/landing/navbar";
import { Pricing } from "@/components/landing/pricing";
import { Workflow } from "@/components/landing/workflow";

export default function Home() {
  return (
    <div className="aurora isolate flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <Hero />
        <Marquee />
        <Features />
        <Workflow />
        <Architecture />
        <Pricing />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
