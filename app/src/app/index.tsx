import { type FC } from "react";

import { useConnection } from "@/pager/connection-provider";
import { HistoryScreen } from "@/screens/history/history-screen";
import { OnboardingScreen } from "@/screens/onboarding/onboarding-screen";

const HistoryRoute: FC = () => {
  const { approved } = useConnection();
  return approved ? <HistoryScreen /> : <OnboardingScreen />;
};
export default HistoryRoute;
