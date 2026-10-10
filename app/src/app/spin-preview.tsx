import { type FC } from "react";

import { Redirect } from "expo-router";

import { Screen } from "@/components/ui/screen";
import { Typography } from "@/components/ui/typography";
import { spinPreviews } from "@/pager/spin-preview-data";
import { MessageRow } from "@/screens/history/message-row";

const SpinPreviewRoute: FC = () => {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen scroll style={{ padding: 0 }}>
      <Typography variant="caption" style={{ paddingHorizontal: 16 }}>
        Preview data · Tap SPIN report to expand
      </Typography>
      {spinPreviews.map(({ message, event }) => (
        <MessageRow key={message.id} message={message} spinEvent={event} />
      ))}
    </Screen>
  );
};
export default SpinPreviewRoute;
