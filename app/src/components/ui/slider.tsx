import { type FC } from "react";

import {
  Host,
  Slider as ExpoSlider,
  type SliderProps as ExpoSliderProps,
} from "@expo/ui";

import { useTheme } from "@/theme/use-theme";

interface SliderProps extends ExpoSliderProps {
  commitOnEnd?: boolean;
}

export const Slider: FC<SliderProps> = (props) => {
  const {
    commitOnEnd = false,
    onSlidingComplete,
    onValueChange,
    ...sliderProps
  } = props;
  const theme = useTheme();

  return (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <ExpoSlider
        maximumTrackTintColor={theme.colors.backgroundSelected}
        minimumTrackTintColor={theme.colors.accent}
        onSlidingComplete={(value) => {
          if (commitOnEnd) {
            onValueChange?.(value);
          }

          onSlidingComplete?.(value);
        }}
        onValueChange={commitOnEnd ? undefined : onValueChange}
        thumbTintColor={theme.colors.accent}
        {...sliderProps}
      />
    </Host>
  );
};
