import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * The app has one entry point per context: the embedded admin for merchants who
 * have installed it, and the login form for everyone else. Nothing renders here.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  throw redirect("/auth/login");
};
