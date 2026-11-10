import { useEffect, useState } from 'react';
import { DayClose } from './DayClose.tsx';
import { Reports } from './Reports.tsx';
import { Settlements } from './Settlements.tsx';
import { Tablets } from './Tablets.tsx';
import { RefusedAck } from '../RefusedBanner.tsx';
import { api, type Me } from './api.ts';

/** The manager's four areas. Profile, text size, theme and Sign out live in the header's More menu (see App.tsx). */
export function ManagerTools({ token, outletId, deviceId, onProfile }: { token: string; outletId?: string; deviceId?: string; onProfile?: (name: string) => void }) {
  const [tab, setTab] = useState<'close' | 'reports' | 'settle' | 'tablets'>('close');
  const [blocking, setBlocking] = useState(0);
  useEffect(() => {
    void api('/me', token).then((r) => { if (r.status === 200) onProfile?.((r.body as Me).name); }).catch(() => { /* the menu just says "Manager" */ });
  }, [token, onProfile]);
  return (
    <div className="m-wrap">
      {outletId && <RefusedAck token={token} outletId={outletId} />}
      <nav className="m-tabs" role="tablist">
        <button data-testid="mgr-tab-close" role="tab" aria-selected={tab === 'close'} className={tab === 'close' ? 'active' : ''} onClick={() => setTab('close')}>
          Close the day {blocking > 0 && <span className="m-count" aria-label={`${blocking} to sort out`}>{blocking}</span>}
        </button>
        <button data-testid="mgr-tab-reports" role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Reports</button>
        <button data-testid="mgr-tab-settle" role="tab" aria-selected={tab === 'settle'} className={tab === 'settle' ? 'active' : ''} onClick={() => setTab('settle')}>Settlements</button>
        <button data-testid="mgr-tab-tablets" role="tab" aria-selected={tab === 'tablets'} className={tab === 'tablets' ? 'active' : ''} onClick={() => setTab('tablets')}>Tablets</button>
      </nav>
      {tab === 'close' ? <DayClose token={token} onBlockers={setBlocking} /> : tab === 'reports' ? <Reports token={token} />
        : tab === 'settle' ? <Settlements token={token} /> : <Tablets token={token} thisDeviceId={deviceId} />}
    </div>
  );
}
