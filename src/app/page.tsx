import { Dashboard } from '@/components/Dashboard';

export default function Page() {
  return (
    <Dashboard
      defaultManagerId={process.env.NEXT_PUBLIC_DEFAULT_MANAGER_ID}
      defaultSquad={process.env.NEXT_PUBLIC_DEFAULT_SQUAD}
      defaultBank={process.env.NEXT_PUBLIC_DEFAULT_BANK}
    />
  );
}
