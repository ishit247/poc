import { useCallback, useEffect, useState } from 'react';
import { DayClose } from './DayClose.tsx';
import { MenuEditor } from './MenuEditor.tsx';
import { Modal } from './Modal.tsx';
import { Platforms } from './Platforms.tsx';
import { Reports } from './Reports.tsx';
import { Settings } from './Settings.tsx';
import { Settlements } from './Settlements.tsx';
import { Tablets } from './Tablets.tsx';
import { RefusedAck } from '../RefusedBanner.tsx';
import { api, type Me } from './api.ts';
import { t, useT } from '../i18n.ts';

type Tab = 'close' | 'reports' | 'settle' | 'platforms' | 'tablets' | 'menu' | 'settings';

/** The manager's seven areas. Profile, text size, theme and Sign out live in the header's More menu (see App.tsx). */
export function ManagerTools({ token, outletId, deviceId, onProfile }: { token: string; outletId?: string; deviceId?: string; onProfile?: (name: string) => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('close');
  const [blocking, setBlocking] = useState(0);
  const [menuDirty, setMenuDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<Tab | null>(null);
  const onMenuDirty = useCallback((d: boolean) => setMenuDirty(d), []);
  useEffect(() => {
    void api('/me', token).then((r) => { if (r.status === 200) onProfile?.((r.body as Me).name); }).catch(() => { /* the menu just says "Manager" */ });
  }, [token, onProfile]);
  // Leaving the menu with unsaved edits asks first: the draft lives only in that screen.
  const go = (t: Tab) => { if (tab === 'menu' && menuDirty && t !== 'menu') setLeaveTo(t); else setTab(t); };
  const btn = (t: Tab, label: string, extra?: React.ReactNode) => (
    <button data-testid={`mgr-tab-${t}`} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => go(t)}>{label}{extra}</button>
  );
  return (
    <div className="m-wrap">
      {outletId && <RefusedAck token={token} outletId={outletId} />}
      <nav className="m-tabs" role="tablist">
        {btn('close', t('Close the day'), blocking > 0 && <span className="m-count" aria-label={t('{n} to sort out', { n: blocking })}>{blocking}</span>)}
        {btn('reports', t('Reports'))}
        {btn('settle', t('Settlements'))}
        {btn('platforms', t('Platforms'))}
        {btn('menu', t('Menu'))}
        {btn('tablets', t('Tablets'))}
        {btn('settings', t('Settings'))}
      </nav>
      {tab === 'close' ? <DayClose token={token} onBlockers={setBlocking} /> : tab === 'reports' ? <Reports token={token} />
        : tab === 'settle' ? <Settlements token={token} /> : tab === 'menu' ? <MenuEditor token={token} onDirty={onMenuDirty} />
        : tab === 'settings' ? <Settings token={token} /> : tab === 'platforms' ? <Platforms token={token} /> : <Tablets token={token} thisDeviceId={deviceId} />}
      {leaveTo && (
        <Modal title={t('Leave without saving?')} onClose={() => setLeaveTo(null)}>
          <p>{t('Your menu changes are not saved. Leaving loses them.')}</p>
          <div className="actions"><button onClick={() => setLeaveTo(null)}>{t('Keep editing')}</button>
            <button className="danger" data-testid="mgr-leave-menu" onClick={() => { setTab(leaveTo); setLeaveTo(null); }}>{t('Leave')}</button></div>
        </Modal>
      )}
    </div>
  );
}
