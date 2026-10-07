#!/usr/bin/env python3
"""Filter a CSV to only rows whose 'year' column falls within a given range."""

import argparse
import csv


def main():
    parser = argparse.ArgumentParser(description="Filter CSV rows by year range.")
    parser.add_argument("input_csv", help="Path to the CSV file to filter.")
    parser.add_argument("output_csv", help="Path to write the filtered CSV to.")
    parser.add_argument("start_year", type=int, help="Start year (inclusive).")
    parser.add_argument("end_year", type=int, help="End year (inclusive).")
    args = parser.parse_args()

    with open(args.input_csv, newline="") as infile:
        reader = csv.DictReader(infile)
        fieldnames = reader.fieldnames
        rows = [
            row for row in reader
            if args.start_year <= int(row["year"]) <= args.end_year
        ]

    with open(args.output_csv, "w", newline="") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
