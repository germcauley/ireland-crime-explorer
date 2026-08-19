import type { Metadata } from "next";
import dashboard from "@/data/processed/dashboard.json";
import { CrimeExplorer } from "./components/CrimeExplorer";

export const metadata: Metadata = {
  title: "Dublin Crime Explorer",
  description:
    "Explore official CSO recorded crime by Dublin Garda station geography, or by Garda Division nationwide.",
};

export default function Home() {
  return <CrimeExplorer data={dashboard} />;
}
