import { Avatar } from "@/components/common/Avatar";
import { Button } from "@/components/motion/button/base";
import type { RecentUser } from "@/lib/recent";

export interface RecentUsersProps {
  users: ReadonlyArray<RecentUser>;
  onPick: (login: string) => void;
}

const MAX_SHOWN = 8;

/** One-tap return to a user looked up before; stays silent until there is one. */
export function RecentUsers({ users, onPick }: RecentUsersProps) {
  if (users.length === 0) return null;

  const shown = users.slice(0, MAX_SHOWN);

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-3"
      aria-labelledby="recent-lookups"
    >
      <h2 id="recent-lookups" className="text-base font-semibold tracking-tight">
        Recent lookups
      </h2>

      <div className="flex flex-wrap gap-2">
        {shown.map((user) => (
          <Button key={user.login} variant="secondary" size="sm" onClick={() => onPick(user.login)}>
            <Avatar login={user.login} name={user.name} size={20} />
            {user.name ?? user.login}
          </Button>
        ))}
      </div>
    </section>
  );
}
