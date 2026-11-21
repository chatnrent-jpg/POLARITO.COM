import { redirect } from "next/navigation";

/** The old single-ticker dashboard is gone: polarito.com is the SPY desk. */
export default function Home(): never {
  redirect("/spy");
}
