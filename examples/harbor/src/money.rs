pub type Money = i64;

#[derive(Clone, Debug)]
pub struct LineItem {
    pub unit_price: Money,
    pub quantity: u32,
    pub discount_percent: u8,
}

impl LineItem {
    /// The line amount in cents, before discounts.
    pub fn total(&self) -> Money {
        self.unit_price * i64::from(self.quantity)
    }
}

/// Sum line totals after discounts.
pub fn calculate_total(items: &[LineItem]) -> Money {
    items
        .iter()
        .map(|item| apply_discount(item.total(), item.discount_percent))
        .sum()
}

/// Apply a percentage discount using integer cents.
pub fn apply_discount(amount: Money, percent: u8) -> Money {
    amount * i64::from(100 - percent.min(100)) / 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_include_quantity_and_discount() {
        let items = [LineItem {
            unit_price: 1200,
            quantity: 2,
            discount_percent: 10,
        }];
        assert_eq!(calculate_total(&items), 2160);
    }
}
