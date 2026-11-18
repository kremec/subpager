import { type ComponentType, type FC } from "react";

import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCircleX,
  IconCopy,
  IconDots,
  IconMapPin,
  IconSearch,
  IconX,
} from "@tabler/icons-react-native";
import type { IconProps } from "@tabler/icons-react-native";

export enum IconName {
  CHECK = "check",
  CHEVRON_DOWN = "chevron-down",
  CHEVRON_UP = "chevron-up",
  CIRCLE_X = "circle-x",
  COPY = "copy",
  DOTS = "dots",
  MAP_PIN = "map-pin",
  SEARCH = "search",
  X = "x",
}

const icons = {
  [IconName.CHECK]: IconCheck,
  [IconName.CHEVRON_DOWN]: IconChevronDown,
  [IconName.CHEVRON_UP]: IconChevronUp,
  [IconName.CIRCLE_X]: IconCircleX,
  [IconName.COPY]: IconCopy,
  [IconName.DOTS]: IconDots,
  [IconName.MAP_PIN]: IconMapPin,
  [IconName.SEARCH]: IconSearch,
  [IconName.X]: IconX,
} satisfies Record<IconName, ComponentType<IconProps>>;

interface AppIconProps extends IconProps {
  name: IconName;
  filled?: boolean;
}

export const Icon: FC<AppIconProps> = (props) => {
  const { name, filled = false, strokeWidth, ...iconProps } = props;
  const Component = icons[name];

  return (
    <Component
      {...iconProps}
      fill={filled ? iconProps.color : "transparent"}
      strokeWidth={filled ? 0 : (strokeWidth ?? 1.8)}
    />
  );
};
