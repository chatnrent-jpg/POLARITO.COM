import SpyDeskPage from "@/components/spy/SpyDeskPage";
import { MONTHLY_PROFILE } from "@/lib/spyProfile";

export const metadata = { title: "Polarito: SPY desk (dry run)" };

export default function SpyPage() {
  return <SpyDeskPage profile={MONTHLY_PROFILE} />;
}
