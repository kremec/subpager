import { type FC } from "react";

import { Redirect, useLocalSearchParams } from "expo-router";

import { useConnection } from "@/pager/connection-provider";
import { SearchScreen } from "@/screens/search/search-screen";

const SearchRoute: FC = () => {
  const { approved } = useConnection();
  const { spinPreview } = useLocalSearchParams<{ spinPreview?: string }>();
  return approved ? (
    <SearchScreen spinPreview={__DEV__ && spinPreview === "1"} />
  ) : (
    <Redirect href="/" />
  );
};

export default SearchRoute;
