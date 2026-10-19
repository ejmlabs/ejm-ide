use crate::money::{Money, calculate_total};
use crate::payments::charge;
use crate::{Error, Order, Receipt, Store};

/// Settle an order after a successful payment.
///
/// The order key also identifies the payment, so a retry is safe.
pub fn settle_order(order: &Order, store: &impl Store) -> Result<Receipt, Error> {
    if let Some(receipt) = store.find_receipt(&order.key)? {
        return Ok(receipt);
    }

    let total = calculate_total(&order.items);
    let receipt = charge(order, total)?;
    store.save_receipt(&receipt)?;
    Ok(receipt)
}

/// Preview the amount before collecting payment.
pub fn quote_order(order: &Order) -> Money {
    calculate_total(&order.items)
}
