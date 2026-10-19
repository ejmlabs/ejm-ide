# frozen_string_literal: true

# Order totals expressed in integer cents.
module Harbor
  # Adds the amounts for every line item.
  def self.calculate_total(amounts)
    amounts.sum
  end

  def self.settle_order(amounts)
    calculate_total(amounts)
  end
end
