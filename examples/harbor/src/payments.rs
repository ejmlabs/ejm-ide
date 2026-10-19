use crate::money::Money;
use crate::{Error, Order, Receipt};

/// Sample payment adapter. A real provider should use `order.key`
/// as its idempotency key before charging.
pub fn charge(order: &Order, amount: Money) -> Result<Receipt, Error> {
    if amount < 0 {
        return Err(Error("The amount cannot be negative".into()));
    }
    Ok(Receipt {
        order_key: order.key.clone(),
        amount,
    })
}
