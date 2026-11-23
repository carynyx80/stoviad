import Nav from "@/components/landing/Nav";
import Hero from "@/components/landing/Hero";
import Ticker from "@/components/landing/Ticker";
import Stats from "@/components/landing/Stats";
import HowItWorks from "@/components/landing/HowItWorks";
import WhySealed from "@/components/landing/WhySealed";
import Fees from "@/components/landing/Fees";
import FinalCTA from "@/components/landing/FinalCTA";
import Footer from "@/components/landing/Footer";

export default function Home() {
  return (
    <main className="st-grain relative min-h-screen overflow-x-clip">
      <Nav />
      <Hero />
      <Ticker />
      <Stats />
      <HowItWorks />
      <WhySealed />
      <Fees />
      <Ticker reverse tone="gold" />
      <FinalCTA />
      <Footer />
    </main>
  );
}
