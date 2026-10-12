import { useApi, useLiveList } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { dayTime, eur, range } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { session, today } from '../../shared/session.js';
import { EmptyState, PageHeader, Skeleton, StatusBadge } from '../../shared/ui.jsx';

export function QuotesPage() {
  const { data, reload } = useApi(`/api/quotes?buyer=${session.buyer.id}`);
  // Live (L2.11 fixture): a request sent from another device shows up within a second, highlighted.
  const fresh = useLiveList(reload, data);
  return (
    <>
      <PageHeader title="Quotes" description="Your quote requests and the roasters’ proposals." />
      <div className="card" style={{ overflow: 'hidden' }}>
        {!data ? (
          <div style={{ padding: 22 }}>
            <Skeleton h={64} />
          </div>
        ) : data.length === 0 ? (
          <EmptyState icon="receipt" title="No quotes yet">
            Open any coffee and choose “Request a quote”.
          </EmptyState>
        ) : (
          data.map((q) => (
            <Link key={q.id} to={`/quotes/${q.id}`} className={fresh.has(q.id) ? 'quote-row row-new' : 'quote-row'} data-quote={q.id}>
              <CoffeeArt palette={q.product?.palette} seed={q.product_slug} beansCount={0} variant="crop" />
              <div>
                <div className="k">
                  {q.reference}
                  {fresh.has(q.id) ? <span className="new-pill">New</span> : null}
                </div>
                <div className="q-name">{q.product?.name}</div>
              </div>
              <div>
                <div className="k">Quantity</div>
                <div className="v">
                  {q.bags} × {q.bag_size}
                </div>
              </div>
              <div>
                <div className="k">Delivery window</div>
                <div className="v">{range(q.window_start, q.window_end)}</div>
              </div>
              <div>
                <div className="k">{q.proposal ? 'Proposal' : 'Requested'}</div>
                <div className="v">{q.proposal ? eur(q.proposal.total_eur) : dayTime(q.created_at, today)}</div>
              </div>
              <div>
                <StatusBadge status={q.status} />
              </div>
              <Icon name="chevronRight" size={18} style={{ color: 'var(--faint)' }} />
            </Link>
          ))
        )}
      </div>
    </>
  );
}
