# Loads ReturnTrip's trusted source into a running Sure instance without using Sure's importer,
# so the importer under test never touches the reference data.
# Usage (inside the web container): bin/rails runner /returntrip/seed_sure.rb /returntrip/source.csv
require "csv"

PASSWORD = ENV.fetch("RT_SURE_PASSWORD", "returntrip-local-1")
SOURCE_EMAIL = "sure-source@returntrip.test"
RESTORE_EMAIL = "sure-restore@returntrip.test"
ACCOUNT_NAME = "Everyday Checking"

# The instance persists between runs: retire the previous run's users so every run starts from
# a fresh source family and an empty restore family.
[SOURCE_EMAIL, RESTORE_EMAIL].each do |email|
  User.where(email: email).find_each { |user| user.update_columns(email: "retired-#{user.id}@returntrip.test") }
end

def build_family!(name, email)
  family = Family.create!(name: name, currency: "USD", locale: "en", country: "US",
                          timezone: "UTC", date_format: "%Y-%m-%d")
  user = family.users.create!(email: email, first_name: "Return", last_name: "Trip", role: "admin",
                              password: PASSWORD, onboarded_at: Time.current)
  begin
    user.mark_release_seen!(Sure.version.to_release_tag)
  rescue StandardError => error
    warn "release notice left in place: #{error.message}"
  end
  account = family.accounts.create!(accountable: Depository.new(subtype: "checking"), name: ACCOUNT_NAME,
                                    balance: 0, currency: "USD", owner: user)
  [family, account]
end

_, source_account = build_family!("ReturnTrip Source", SOURCE_EMAIL)
build_family!("ReturnTrip Restore", RESTORE_EMAIL)

rows = CSV.read(ARGV.fetch(0), headers: true)
Entry.transaction do
  rows.each do |row|
    source_account.entries.create!(
      entryable: Transaction.new,
      date: Date.iso8601(row.fetch("date")),
      amount: BigDecimal(row.fetch("amount")),
      name: row.fetch("name"),
      currency: row.fetch("currency"),
      notes: row.fetch("notes")
    )
  end
end
puts "seeded #{rows.size} transactions for #{SOURCE_EMAIL}; #{RESTORE_EMAIL} has an empty #{ACCOUNT_NAME}"
