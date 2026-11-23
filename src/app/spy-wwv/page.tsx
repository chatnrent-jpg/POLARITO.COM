import SpyDeskPage from "@/components/spy/SpyDeskPage";
import { WWV_PROFILE } from "@/lib/spyProfile";

export const metadata = { title: "Polarito: SPY DESK WWV, Daily WWV (dry run)" };

export default function SpyWwvPage() {
  return <SpyDeskPage profile={WWV_PROFILE} />;
}
