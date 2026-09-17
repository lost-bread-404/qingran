import { Button } from "@/components/ui/button";

export function LogoutButton() {
  return (
    <form method="post" action="/api/logout">
      <Button type="submit" variant="outline" size="sm">
        退出登录
      </Button>
    </form>
  );
}
