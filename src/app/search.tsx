import { type FC } from "react";

import { Redirect } from "expo-router";

import { useConnection } from "@/pager/connection-provider";
import { SearchScreen } from "@/screens/search/search-screen";

const SearchRoute: FC = () => {
  const { approved } = useConnection();
  return approved ? <SearchScreen /> : <Redirect href="/" />;
};

export default SearchRoute;
