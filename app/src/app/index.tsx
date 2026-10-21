import { Fragment, type FC } from "react";

import { useLocalSearchParams } from "expo-router";

import { useConnection } from "@/pager/connection-provider";
import { HistoryScreen } from "@/screens/history/history-screen";
import { OnboardingScreen } from "@/screens/onboarding/onboarding-screen";

const HistoryRoute: FC = () => {
  const { approved } = useConnection();
  const { spinPreview } = useLocalSearchParams<{ spinPreview?: string }>();
  return (
    <Fragment>
      {approved && (
        <HistoryScreen spinPreview={__DEV__ && spinPreview === "1"} />
      )}
      {!approved && <OnboardingScreen />}
    </Fragment>
  );
};
export default HistoryRoute;
